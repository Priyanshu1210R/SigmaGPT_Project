# CS-210 Java Lab Handbook (v3.1)

## 1. Overview

CS-210 is a second-year course on data structures and algorithms taught in Java 17. Students write their own versions of the core structures in the package edu.lab.ds before they are allowed to use the standard java.util collections in the final project. The current handbook is version 3.1. Every lab class is final unless the assignment explicitly asks for inheritance, and every submission must compile with no warnings.

## 2. JVM Memory and Strings

The JVM divides memory into the heap, the thread stacks, and the metaspace. Objects live on the heap, while local variables and method frames live on the stack of the thread that runs them. The lab scripts start every program with the flag -Xss512k, which gives each thread a stack of 512 KB. Because of that small stack, a recursive method that goes deeper than 10,000 calls must be rewritten as a loop, or the grader will report a StackOverflowError.

Strings in Java are immutable, and literals are shared through the string pool. For that reason two literals with the same text are == to each other, but a string built with new String("lab") is not, so the course always compares strings with equals. When a loop concatenates strings more than 50 times, students must use StringBuilder instead of the + operator, because each + creates a new String object.

## 3. Object-Oriented Basics

An interface describes a capability, while an abstract class can also hold state and partial implementations; a class may implement many interfaces but extend only one class. The equals and hashCode contract says that two objects that are equal must return the same hash code. The lab requires hashCode to be written with Objects.hash and never with a random or time-based value. Overriding equals without overriding hashCode is the most common reason a student's key cannot be found in a HashMap, and it costs 5 marks on every assignment where it appears.

## 4. Generics and Ordering

Lab data structures are generic, so LabList<T> and LabHeap<T> work with any element type. Generics are erased at run time, which is why Java does not allow new T[capacity]; the lab code instead creates an Object[] and casts it to T[]. Elements that must be ordered implement Comparable<T>, whose compareTo method defines the natural ordering, or the caller passes a Comparator. The lab requires compareTo to be consistent with equals, meaning compareTo returns 0 exactly when equals returns true, because TreeMap and PriorityQueue rely on that behavior.

## 5. Exceptions

Java separates checked exceptions, which the compiler forces the caller to handle, from unchecked exceptions, which extend RuntimeException. The lab library defines one custom exception, LabException, and it is unchecked. Resources such as readers must be opened with try-with-resources so that they are closed automatically. Students must never catch Throwable. A finally block always runs, even when the try block ends with a return statement, and the only common way to skip it is a call to System.exit.

## 6. Lists and Hash Maps

The standard ArrayList keeps its elements in an array and grows by about 1.5 times when it is full. The lab's own LabList is different: it starts with an initial capacity of 8 and doubles its array each time it fills. Adding to the end is amortized O(1), but inserting at the front is O(n) because every element must shift. A LinkedList has O(1) insertion at the head but O(n) access by index, which is why the course says to prefer ArrayList in almost every case.

The standard HashMap starts with 16 buckets, a load factor of 0.75, and converts a bucket's linked list into a tree once the list reaches 8 entries. The lab's LabHashMap uses separate chaining and starts with 32 buckets. It resizes by doubling the bucket array when the load factor passes 0.6, and it has no treeification, so students must keep their hash functions well spread. HashMap allows one null key, while Hashtable allows none.

## 7. Linked Lists

LabLinkedList is doubly linked and uses a sentinel head node and a sentinel tail node, so insertion and removal never need special cases for an empty list. Reversing a singly linked list takes O(n) time and O(1) extra space by walking the list with three pointers: previous, current, and next. To detect a cycle the course teaches Floyd's tortoise and hare method, in which the tortoise moves 1 node per step and the hare moves 2 nodes per step; if the two ever meet, the list has a cycle.

## 8. Hashing Details

String.hashCode multiplies by 31 for each character, and the lab accepts the same approach for custom keys. LabHashMap turns a hash code into a bucket index with (hash & 0x7fffffff) % capacity, which clears the sign bit so the index is never negative. Two different keys that land in the same bucket are called a collision, and they are stored in that bucket's chain. A HashSet is backed by a HashMap, so it inherits the same average O(1) cost for add, remove, and contains.

## 9. Concurrency

A Java thread can be created by extending Thread or, preferably, by submitting a Runnable to an ExecutorService. The lab assignments use a fixed thread pool of exactly 4 threads, because the grading machines have 4 cores. The keyword synchronized gives mutual exclusion on an object's monitor, while volatile only guarantees visibility of a variable and does not make count++ atomic. For that, students use AtomicInteger. To prevent deadlock, the course requires that locks are always acquired in the same global order. ConcurrentHashMap is the approved thread-safe map, and a plain HashMap must never be shared between threads.

## 10. Stacks, Queues, and Heaps

The lab uses ArrayDeque for both stacks and queues, and the old Stack class is banned because it is synchronized and slow. A PriorityQueue in the standard library is a binary min-heap, so offer and poll take O(log n) time while peek takes O(1). The lab's own LabHeap stores its elements in an array starting at index 1, which leaves index 0 unused. For a node at index i, the left child is at 2i, the right child at 2i + 1, and the parent at i / 2 using integer division. Building a heap from n elements with bottom-up heapify takes O(n) time, not O(n log n).

## 11. Trees

A binary search tree keeps smaller keys in the left subtree and larger keys in the right subtree, so an in-order traversal visits the keys in sorted order. In the worst case, such as inserting already sorted keys, a plain BST degenerates into a linked list with O(n) operations. The lab's LabAvl tree prevents this by keeping the balance factor of every node between -1 and 1, and it fixes violations with single or double rotations. The standard TreeMap is not an AVL tree but a red-black tree, and its get, put, and remove all run in O(log n).

## 12. Graphs

The lab represents graphs with an adjacency list, because the test graphs are sparse and an adjacency matrix would waste memory. Vertices in LabGraph are numbered from 0 to n-1. Breadth-first search uses a queue and finds the shortest path in an unweighted graph, while depth-first search uses a stack or recursion. Dijkstra's algorithm uses a PriorityQueue and runs in O((V + E) log V), but it gives wrong answers when an edge has a negative weight, so the course uses Bellman-Ford for those graphs. Detecting a cycle in a directed graph requires three vertex colors (white, gray, black) instead of a simple visited flag.

## 13. Sorting and Searching

For primitives, Arrays.sort uses dual-pivot quicksort, which is not stable. For objects it uses TimSort, which is stable and runs in O(n log n) time. The lab's own merge sort switches to insertion sort when a sub-array has fewer than 16 elements. Binary search requires a sorted array and runs in O(log n). The lab requires the middle index to be computed as low + (high - low) / 2 instead of (low + high) / 2, because the sum of two large ints can overflow. Students lose 3 marks if they use the overflow-prone form.

## 14. Recursion and Backtracking

Every recursive method needs a base case and a step that moves toward it. Backtracking explores a choice, recurses, and then undoes the choice before trying the next one. The lab's standard backtracking exercise is the N-Queens puzzle, and its tests use a board with n = 8, which has 92 solutions. Tail calls are not optimized by the JVM, so even a tail-recursive method uses one stack frame per call.

## 15. Dynamic Programming and Complexity

A problem suits dynamic programming when it has overlapping subproblems and optimal substructure. Computing Fibonacci numbers with naive recursion takes exponential time, but memoization reduces it to O(n). The lab prefers bottom-up tables to recursion because of the small stack described in section 2. The auto-grader gives every test a timeout of 2 seconds, and the largest input has n = 100,000, so a solution slower than O(n log n) will usually fail the large tests.

## 16. Java 17 Features and Garbage Collection

The lab allows records for small immutable value classes, but the data structures themselves must be ordinary classes. The keyword var is allowed only when the type is obvious from the right-hand side. Streams are permitted in test code but banned inside the structures of edu.lab.ds, because they hide the loops that the complexity analysis is meant to count. Garbage collection reclaims objects that are no longer reachable. Calling System.gc() is only a hint, so programs must never depend on it, and overriding finalize is forbidden.

## 17. Grading

Each assignment is worth 100 marks: 60 for passing tests, 20 for code style, and 20 for a written complexity analysis. Solutions are submitted through the course portal and are checked by the auto-grader overnight.

## 18. Version History

Version 2.4 of this handbook specified older values: LabList grew by 1.5 times, LabHashMap started with 16 buckets and resized at a load factor of 0.75, programs ran with -Xss1m, and the thread pool had 8 threads. All four values were changed in version 3.0.
